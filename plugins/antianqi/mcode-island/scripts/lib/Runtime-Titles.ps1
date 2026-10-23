# ---------------------------------------------------------------------------
# 会话标题（运行时 SQLite）
#
# 灵动岛的 session 列表第一行想显示"会话标题"，而不是"首条提问的前 40 个
# 字"。首条提问常常是一句长话、半个 URL、或者"继续收尾能力清单面板这轮
# 的活。先看静态扫描器现在的状态。" —— 截断之后既不好看，也认不出是哪个
# 会话。
#
# 真正的标题在 MiniMax Code 运行时的 SQLite 里：
#
#   ~/.minimax/v2/sqlite/runtime-state.sqlite
#   表 local_runtime_sessions，列 title
#
# 那 417 个会话里有 413 个带标题，而且是提炼过的主题句（"修复 MCode
# 0.6.13 更新失败"这种），不是首条消息的截断。
#
# # 为什么不是直接读
#
# PowerShell 没有内置的 SQLite 读取器，而插件不能带二进制依赖（Skill-only、
# 零 npm 依赖是硬约束）。所以这里借一个已经在机器上的 node：
#
#   - node:sqlite 是 Node 22.5+ 的**内置**模块，不是 npm 依赖；
#   - CLI 安装自带 node（~/.minimax-code/runtime/node-<ver>/node.exe）；
#   - 桌面端 app 是 Electron，ELECTRON_RUN_AS_NODE=1 之后它就是 node。
#
# 找不到任何能用的运行时，整个功能就关掉：列表退回"首条提问"，也就是
# 这个能力上线之前的样子。和 scripts/lib/Get-5hUsage.ps1 同一个套路 ——
# lib 不在，链路关闭，detector 一行都不用改。
#
# # 只读
#
# 只读打开，不写、不建索引、不迁移。应用自己的锁和 WAL 由 SQLite 处理，
# 和应用同时开着也不冲突（实测过）。
# ---------------------------------------------------------------------------

# 查到的标题：session id -> 标题
$script:runtimeTitles = @{}
# 标题的缓存时间戳。标题很少变，60s 查一次足够。
$script:runtimeTitlesAt = [DateTime]::MinValue
# 标题的缓存有效期
$script:RUNTIME_TITLES_TTL_MS = 60 * 1000
# 节点脚本跑多久算超时。1.9GB 的库打开要读页，1.5s 足够；超了就当没有。
$script:RUNTIME_TITLES_TIMEOUT_MS = 1500

# 用户主目录。Windows 是 USERPROFILE，Linux/macOS 是 HOME —— CI 的 ubuntu
# job 没有 USERPROFILE，Join-Path $null 会抛异常，所以这里必须自己兜住。
function Get-UserHome {
  foreach ($v in @($env:USERPROFILE, $env:HOME)) {
    if ($v) { return [string]$v }
  }
  return ''
}

# 找一个能用的 node。
#
# 顺序有讲究：
#   1. PATH 上的 node         —— 开发者机器上最常见的
#   2. CLI 自带的 node        —— ~/.minimax-code/runtime/node-*/node.exe
#   3. 桌面端 app 当 node 用  —— ELECTRON_RUN_AS_NODE=1
#
# 第 3 条是给上架版用的：桌面端用户不一定装了 node，但一定跑着 app。
#
# **这个函数不许抛异常**：没有 node 就是没有标题，不是错误。
function Get-NodeCommand {
  try {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return @{ Exe = $c.Source; Env = $null } }

    # CLI 自带：~/.minimax-code/runtime/node-vXX.Y.Z-win-x64/node.exe
    $home = Get-UserHome
    if ($home) {
      $runtimeRoot = Join-Path $home '.minimax-code\runtime'
      if (Test-Path -LiteralPath $runtimeRoot) {
        $nodeExe = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Depth 2 -File -Filter 'node.exe' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($nodeExe) { return @{ Exe = $nodeExe.FullName; Env = $null } }
      }
    }

    # 桌面端 app：ELECTRON_RUN_AS_NODE=1 之后 Electron 就是 node。
    #
    # 从已经在跑的进程里拿 exe 路径，比去 Program Files 里猜安装位置可靠：
    # 装在哪、怎么升级都不会失配。
    $names = @('MiniMax Inside Code', 'MiniMax Code', 'Mavis')
    foreach ($n in $names) {
      $proc = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
      if ($proc) { return @{ Exe = $proc.Path; Env = 'ELECTRON_RUN_AS_NODE=1' } }
    }
  } catch {
    # 找不到就是找不到。
  }
  return $null
}

# 用 node 读一次标题表。
#
# 返回 @{ id -> title }，读不到就返回空表。**任何失败都只是少一个标题**，
# 不该把 detector 带崩：所以这里只吞异常，不往上抛。
#
# 整个函数体都在 try 里，包括路径拼接 —— CI 的 ubuntu job 没有
# USERPROFILE，Join-Path $null 会抛，那次失败就是这么来的。
function Read-RuntimeTitles {
  $result = @{}
  $tmp = $null
  try {
    # MCODE_RUNTIME_STATE_DB 可以指向别的库。测试要用一个自己建的临时库，
    # 不然就只能读开发机上那个 1.9GB 的真库。
    $db = $env:MCODE_RUNTIME_STATE_DB
    if (-not $db) {
      $home = Get-UserHome
      if (-not $home) { return $result }
      $db = Join-Path $home '.minimax\v2\sqlite\runtime-state.sqlite'
    }
    if (-not (Test-Path -LiteralPath $db)) { return $result }

    $node = Get-NodeCommand
    if (-not $node) { return $result }

    # 内联脚本：node:sqlite 是内置模块，只读打开，把 id -> title 打成 JSON。
    #
    # 全表取而不是按 id 取：表只有几百行，一次读完比拼 IN 子句省事得多，
    # 而且以后多了字段也不用改。
    #
    # argv[1] 是脚本自己的路径，argv[2] 才是传进来的库路径。
    #
    # 扩展名必须是 .cjs：用户目录下的 package.json 里可能有 "type": "module"，
    # 那会让 .js 按 ES module 加载，require() 直接报 "require is not defined"。
    $js = @'
const {DatabaseSync} = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], {readOnly: true});
const out = {};
try {
  for (const r of db.prepare("SELECT session_id, title FROM local_runtime_sessions").all()) {
    if (r && r.title) out[String(r.session_id)] = String(r.title);
  }
} finally { db.close(); }
process.stdout.write(JSON.stringify(out));
'@

    # 临时目录走 .NET 的 GetTempPath()，不用 $env:TEMP。
    #
    # Linux 上的 PowerShell 没有 TEMP（那里叫 TMPDIR），Join-Path $null 会
    # 抛；异常被吞掉之后标题就读不出来了 —— ubuntu CI 上就是这么挂的，
    # 而且失败信息离原因很远。
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('island-titles-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
    [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node.Exe
    $psi.Arguments = '"' + $tmp + '" "' + $db + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($node.Env) { $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
    $proc = [System.Diagnostics.Process]::Start($psi)
    $out = $proc.StandardOutput.ReadToEnd()
    $proc.StandardError.ReadToEnd() | Out-Null
    if (-not $proc.WaitForExit($script:RUNTIME_TITLES_TIMEOUT_MS)) {
      try { $proc.Kill() } catch {}
      return $result
    }
    if ($proc.ExitCode -ne 0) { return $result }
    if (-not $out) { return $result }
    $parsed = $out | ConvertFrom-Json
    foreach ($p in $parsed.PSObject.Properties) { $result[$p.Name] = [string]$p.Value }
  } catch {
    # 读不到就没有标题，列表退回首条提问。
  } finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
      try { [System.IO.File]::Delete($tmp) } catch {}
    }
  }
  return $result
}

# 取某个 session 的标题。
#
# 有缓存：标题很少变，60s 内直接用旧的。
#
# 和读表一样，这里也不许抛：这个函数在 detector 的主循环里被调用，
# 一次异常就是整个列表停摆。
function Get-RuntimeSessionTitle([string]$id) {
  try {
    if (-not $id) { return '' }
    $now = Get-Date
    if (($now - $script:runtimeTitlesAt).TotalMilliseconds -ge $script:RUNTIME_TITLES_TTL_MS) {
      $script:runtimeTitles = Read-RuntimeTitles
      $script:runtimeTitlesAt = $now
    }
    if ($script:runtimeTitles.ContainsKey($id)) { return [string]$script:runtimeTitles[$id] }
  } catch {
    # 没有标题就是没有标题。
  }
  return ''
}
