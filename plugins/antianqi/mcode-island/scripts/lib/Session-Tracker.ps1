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

# 会话标题（运行时的 SQLite）。
#
# lib 不在时整条链路关闭，列表退回"首条提问"—— 也就是这个能力上线之前的
# 样子。跟 scripts/lib/Get-5hUsage.ps1 同一个套路：可选能力，可有可无。
$script:runtimeTitlesAvailable = $false
if (Test-Path (Join-Path $PSScriptRoot 'Runtime-Titles.ps1')) {
  . (Join-Path $PSScriptRoot 'Runtime-Titles.ps1')
  $script:runtimeTitlesAvailable = $true
}

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

# "运行中" 的活性窗口。
#
# 状态不能只由消息类型定。agent 跑完一个工具之后，它的最后一条消息
# 永远是 toolCall 或 toolResult —— 消息类型说它"在跑"，其实它可能早就
# 停了。而日志不再变之后，更新循环会直接跳过，状态会**冻结**在最后
# 一个值：一个停了快一小时的会话会一直显示"运行中"。
#
# 所以"在跑"必须有一份活性支撑：超过这个窗口没动，就不是"在跑"，是
# "停了"。
#
# 5 分钟：长工具（一次几分钟的构建、大文件处理）和长时间的模型推理都
# 不会误伤，用户也不必等一个小时才看到状态变了。
#
# "待回复"不看这个窗口：球在用户那边，用户半小时不回，它还是待回复。
$script:STALE_RUNNING_MS = 5 * 60 * 1000

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

# 这个 session 现在是什么状态。
#
# **和 detector 的 Infer-State 同源**：同一套状态词表、同一套判定规则。
#
# 之前这里自己写了一套 running/waiting/stopped，两边越走越远："用户刚
# 说完"在 pill 上是 idle（等用户），在列表里却是 running；pill 有的
# "已完成"（工具跑完）列表里根本没有。同一个会话在两个地方显示成两回事。
#
# 所以这里直接产出 pill 那套状态：
#
#   working  agent 在干活（跑工具，或者刚跑完一个工具、还要接着干）
#   thinking agent 在想
#   waiting  agent 在等审批（ask_user）—— 球在用户那边
#   idle     agent 说完了，或者用户刚说完 —— 球在用户那边
#
# 注意这里**没有** done 和 error：pill 上的"已完成""出错"是"刚刚跑完
# 一个工具""这个工具炸了"的瞬时反馈，后面还跟着具体动词；放进列表会被
# 读成"这个会话做完了"，而工具跑完之后 agent 还在这一轮里。列表只说
# 会话级的状态。
#
# 只产出状态，不产出 message 和 family —— 那两个是 pill 的活（"Ran"、
# "Read" 这些动词），列表不需要。
function Get-SessionState($msg) {
  if (-not $msg) { return '' }
  $m = $msg.message
  if (-not $m) {
    # ledger 事件格式：{kind, phase, action, ...}
    $kind = [string]$msg.kind
    # 一个工具跑完了，**这一轮还没结束**：agent 还要接着说话或调下一个
    # 工具。所以这里是 working，不是 done。
    if ($kind -eq $S_TOOLRESULT) { return 'working' }
    if ($kind -eq 'toolCall' -or $kind -eq $S_TOOLCALL) {
      if (Test-IsAskUser ([string]$msg.toolName)) { return 'waiting' }
      return 'working'
    }
    if ($kind -eq $S_ASSISTANT -and [string]$msg.phase -eq $S_THINKING) { return 'thinking' }
    return ''
  }
  $role = [string]$m.role
  # 用户刚说完：球在用户那边，agent 马上要动。pill 也判 idle（"等用户"）。
  if ($role -eq $S_USER) { return 'idle' }
  if ($role -eq $S_ASSISTANT) {
    # 和 detector 一样扫一遍 content：toolCall 优先，命中就停。
    $hasTool = $null
    $hasThink = $null
    $hasText = $null
    if ($m.content) {
      foreach ($c in @($m.content)) {
        if     ($hasTool  -eq $null -and $c.type -eq $S_TOOLCALL)  { $hasTool  = $c }
        elseif ($hasThink -eq $null -and $c.type -eq $S_THINK_BLK) { $hasThink = $c }
        elseif ($hasText  -eq $null -and $c.type -eq $S_TEXT)      { $hasText  = $c }
        if ($hasTool) { break }
      }
    }
    if ($hasTool) {
      if (Test-IsAskUser ([string]$hasTool.name)) { return 'waiting' }
      return 'working'
    }
    if ($hasThink -and -not $hasText) { return 'thinking' }
    if ($hasText) { return 'idle' }
    return 'idle'
  }
  # 同上：工具跑完了（成不成都一样），这一轮还在继续。
  #
  # 成功和失败都不改状态 —— 工具级的成败是 pill 的事（它绿点/红点一闪，
  # 后面还跟着"Read""Edited"这类动词，是瞬时反馈）。会话级的状态是
  # "这一轮还在跑"，工具失败也一样：agent 会重试、或者换个办法。
  if ($role -eq $S_TOOLRESULT) { return 'working' }
  return ''
}

# 哪些状态算"一轮的终点"：球不在 agent 那边了。
#
#   idle    agent 说完了，或者用户刚说完
#   waiting agent 在等审批（ask_user）
#   done    工具跑完了
#   stopped agent 挂了
#   error   工具炸了
#
# 这些状态之后又变成 working/thinking，说明新一轮开始了，被点掉的约束
# 该失效。
$script:ROUND_END_STATES = @('idle', 'waiting', 'done', 'stopped', 'error')

# 哪些状态算"在跑"（agent 那边有活）。活性兜底只对它们生效：最后一条
# 消息说它在跑，但太久没动静了，那它不是"在跑"，是"停了"。
$script:ACTIVE_STATES = @('working', 'thinking')

# 最后一条消息的正文摘要（列表的第二行）。
#
# 从同一条消息里取，零额外 IO：Get-LastJsonLine 已经把它读进内存了，
# Get-SessionState 也已经解析过 $m.content，只是没取正文。
#
# 这里只负责"把原文取出来"，不负责怎么排版：摘要的格式（截断长度、
# "执行 <tool>" 这种前缀）归 widget 管，detector 只给原始数据。这样
# 换一种排版不用动 detector。
#
# 取什么，按"用户想看到什么"来定：
#
#   assistant 的正文 -> agent 最后说了什么。这是"待回复"会话里最该看到的
#                      一句话：它到底说了什么、要我干什么。
#   user 的正文      -> 用户最后说了什么。
#   toolCall         -> 只留工具名，widget 拼成"执行 xxx"。agent 正在干活
#                      时最后一条往往就是 toolCall，没有正文可显示，给个
#                      动作名比留空好。
#   toolResult       -> 不取。它的正文是工具输出（代码、日志），不是对话
#                      内容，塞进摘要只会把列表变成日志窗口。
function Get-SessionPreview($msg) {
  if (-not $msg) { return '' }
  $m = $msg.message
  if (-not $m) { return '' }
  $role = [string]$m.role
  # toolResult 的正文是工具输出（代码、日志、文件内容），不是对话内容。
  # 当摘要用会把列表变成日志窗口，所以整条排除。
  if ($role -eq $S_TOOLRESULT) { return '' }
  $text = ''
  foreach ($c in @($m.content)) {
    if ($c.type -eq 'text' -and $c.text -and -not $text) { $text = [string]$c.text; break }
  }
  if (-not $text) { return '' }
  $text = $text -replace '(?s)<system-reminder>.*?</system-reminder>', ''
  $text = ($text -replace '\s+', ' ').Trim()
  return $text
}

# 最后一条消息里的工具名（toolCall）。
#
# 和摘要分开放，因为它们的来源不同：摘要是正文，工具名只在最后一条
# 恰好是 toolCall 时才有。widget 先用摘要，没有再用它兜底。
#
# toolResult 消息也带工具名，但不在 content 里，而在 message.toolName
# 上。agent 跑完一个工具之后，最后一条往往正是 toolResult —— 实测下来
# 那样 preview 是空的（工具输出不当摘要），content 里也没有 toolCall，
# 工具名就漏了，第二行会整个空着。所以这里要认 message.toolName。
function Get-SessionLastTool($msg) {
  if (-not $msg) { return '' }
  $m = $msg.message
  if (-not $m) { return '' }
  foreach ($c in @($m.content)) {
    if ($c.type -eq 'toolCall' -and $c.name) { return [string]$c.name }
  }
  if ($m.PSObject.Properties['toolName'] -and $m.toolName) { return [string]$m.toolName }
  return ''
}

# 这个 session 在列表里显示的名字。
#
# 优先用运行时的会话标题（SQLite 里那个提炼过的主题句："修复 MCode 0.6.13
# 更新失败"）。拿不到就用首条提问 —— 首条提问常常是半个 URL 或者一句
# 长话，截断之后既不好看，也认不出是哪个会话。
function Get-SessionDisplayTitle([string]$id, [string]$log) {
  if ($script:runtimeTitlesAvailable) {
    $t = Get-RuntimeSessionTitle $id
    if ($t) { return $t }
  }
  return (Get-SessionTitle $log)
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
    if ($entry -and $entry.MTime -eq $g.MTime) {
      # 日志没变：消息没变，状态也不该变。
      #
      # 但"运行中"需要一份活性支撑。agent 跑完一个工具之后，它的最后
      # 一条消息永远是 toolCall 或 toolResult —— 消息类型说它"在跑"，
      # 其实它可能早就停了。而这一行原本直接 continue，状态会冻结在
      # 最后一个值：一个停了快一小时的会话会一直显示"运行中"。
      #
      # 所以在这里降级一次：超过窗口没动就不是"在跑"，是"停了"。
      if ($entry.Phase -in $script:ACTIVE_STATES) {
        $ageMs = ($now - $g.MTime).TotalMilliseconds
        if ($ageMs -gt $script:STALE_RUNNING_MS) {
          $entry.Phase = 'stopped'
          $script:sessionsDirty = $true
          Log-Line ("session stopped: " + $id + " (quiet for " + [int]($ageMs / 1000) + "s)")
        }
      }
      continue
    }

    $msg = Get-LastJsonLine $g.Log
    if (-not $msg) { continue }
    $phase = Get-SessionState $msg

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
        # 被点掉过。上次看到它是一轮的终点，现在又在跑 ->
        # 它跑完了一轮又开始，是新的一轮，可以重新进来。
        if (($d.Phase -in $script:ROUND_END_STATES) -and ($phase -in $script:ACTIVE_STATES)) {
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
        Title = (Get-SessionDisplayTitle $id $g.Log)
        Phase = $phase
        Cycle = $cycle
        MTime = $g.MTime
        SinceMs = [int64]([DateTimeOffset]::new($g.MTime).ToUnixTimeMilliseconds())
        # 列表的第二行和右侧时间戳。
        #   Preview  = 最后一条消息的正文（agent 或用户说的）
        #   LastTool = 最后一条消息恰好是 toolCall 时的工具名
        #   LastAtMs = 最后一次活动时间（日志 mtime）。不是"进列表的时间"，
        #              那是 SinceMs；列表右侧显示的是这个。
        Preview = (Get-SessionPreview $msg)
        LastTool = (Get-SessionLastTool $msg)
        # 见过的所有标题。终端 tab 上的名字是 mcode 在某个时刻设的，而
        # 会话标题会随对话推进变，所以要留着历史才匹配得上那个 tab。
        #
        # 首条用户消息也要放进去：tab 上的名字通常就是会话刚起时那个
        # 名字，而运行时那个标题是后来变的。
        Titles = @(@((Get-SessionDisplayTitle $id $g.Log), (Get-SessionTitle $g.Log)) | Where-Object { $_ } | Select-Object -Unique)
        LastAtMs = [int64]([DateTimeOffset]::new($g.MTime).ToUnixTimeMilliseconds())
        Dir = $g.Dir
      }
      $script:sessionsDirty = $true
      Log-Line "session tracked: $id ($phase)"
      continue
    }

    # 已跟踪的：状态变了就更新
    #
    # 一轮的终点（idle/waiting/done/stopped/error）之后又变成在跑
    # （working/thinking），说明新一轮开始了，之前被点掉的约束失效。
    if (($entry.Phase -in $script:ROUND_END_STATES) -and ($phase -in $script:ACTIVE_STATES)) {
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
    # 第二行和右侧时间戳跟着最后一条消息走。
    #
    # 变了就置 dirty。这里原来只看 Phase 变没变：agent 连着跑几个工具时
    # Phase 一直是 running，摘要和最后活动时间却在变，不置 dirty 的话
    # 磁盘上的 sessions.json 会一直停在旧值 —— 列表第二行空着、右侧的
    # 时间戳也不动。内存里是对的，落到文件上却丢了。
    $newPreview = (Get-SessionPreview $msg)
    $newTool    = (Get-SessionLastTool $msg)
    $newAtMs    = [int64]([DateTimeOffset]::new($g.MTime).ToUnixTimeMilliseconds())
    if ($entry.Preview -ne $newPreview -or $entry.LastTool -ne $newTool -or $entry.LastAtMs -ne $newAtMs) {
      $script:sessionsDirty = $true
    }
    $entry.Preview = $newPreview
    $entry.LastTool = $newTool
    $entry.LastAtMs = $newAtMs
    # 标题变了就记进历史（最多留 8 个，够覆盖 tab 标题那个时刻）。
    #
    # 无条件并入当前标题：detector 重启后条目是从 sessions.json 恢复的，
    # 恢复出来的标题和当前标题一样，光靠"变了才记"会一个都记不上。
    $newTitle = (Get-SessionDisplayTitle $id $g.Log)
    if ($newTitle) {
      # 首条用户消息一起并进来：tab 名多半是会话刚起时的那个名字。
      $hist = @(@($entry.Titles) + @($newTitle) + @((Get-SessionTitle $g.Log)) | Where-Object { $_ } | Select-Object -Unique)
      if ($hist.Count -gt 8) { $hist = @($hist | Select-Object -Last 8) }
      $entry.Titles = $hist
    }
    # 运行时标题可能比列表出现得晚（node 装好了、库能读了）。所以每次更新
    # 都再问一次，拿到更好的名字就升级。Get-RuntimeSessionTitle 内部有 60s
    # 缓存，所以每秒问一次并不会每秒起进程。
    if ($script:runtimeTitlesAvailable) {
      $rt = Get-RuntimeSessionTitle $id
      if ($rt -and $rt -ne $entry.Title) {
        $entry.Title = $rt
        $script:sessionsDirty = $true
      }
    }
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
      # 列表第二行 / 右侧时间戳。缺字段的旧条目补空串，不要 null：
      # widget 那边按字符串处理，null 会多一层判空。
      preview = $(if ($e.Preview) { [string]$e.Preview } else { '' })
      lastTool = $(if ($e.LastTool) { [string]$e.LastTool } else { '' })
      lastAtMs = $(if ($e.LastAtMs) { [int64]$e.LastAtMs } else { 0 })
      # 见过的所有标题，widget 拿它去匹配终端 tab。
      titles = @($e.Titles | Where-Object { $_ })
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
        # 第二行和右侧时间戳也要恢复：detector 重启到下一次刷新之间，
        # widget 读的就是这个文件，不能白屏一行。
        Preview = $(if ($s.preview) { [string]$s.preview } else { '' })
        LastTool = $(if ($s.lastTool) { [string]$s.lastTool } else { '' })
        LastAtMs = $(if ($s.lastAtMs) { [int64]$s.lastAtMs } else { 0 })
        Titles = @($s.titles | Where-Object { $_ })
        Dir = ''
      }
    }
    if ($j.dismissed) {
      foreach ($p in $j.dismissed.PSObject.Properties) {
        $v = $p.Value
        # 老格式是一个整数（cycle）。当成"消掉时正在跑"，于是它要等
        # 跑完一轮又开始才回来。
        if ($v -is [int] -or $v -is [long] -or $v -is [double]) {
          $v = @{ Cycle = [int]$v; Phase = 'working' }
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
    $phase = Get-SessionState $msg

    # 两种补录：
    #   - 刚动过（60 秒内）：它此刻真的在跑
    #   - 说完在等你（30 分钟内，且最后一条是 agent 收尾）：detector
    #     重启前它刚说完，那次"从运行中变成待回复"的转换我们没看见，
    #     不补录的话这个"待回复"就永远等不到了
    $isActive = ($g.MTime -ge $activeCut)
    $isFinishedWaiting = ($g.MTime -ge $seedCut) -and ($phase -in $script:ROUND_END_STATES)
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
