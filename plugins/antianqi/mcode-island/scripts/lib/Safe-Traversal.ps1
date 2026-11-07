# ---------------------------------------------------------------------------
# Safe traversal of the sessions root (round-24 review, hetaoBackend).
#
# 为什么需要它
#
# 以前的两个 scanner 都用同一种盲递归：
#
#   [System.IO.Directory]::EnumerateDirectories($root, '*session_*', 'AllDirectories')
#   [System.IO.Directory]::EnumerateFiles($sessionsRoot, '*.jsonl', 'AllDirectories')
#
# 微软的文档写得很清楚：SearchOption.AllDirectories **包含 reparse point**
# （符号链接、junction、挂载点）：
# https://learn.microsoft.com/en-us/dotnet/api/system.io.searchoption?view=net-10.0
#
# 也就是说，sessions 目录底下只要有一个 junction，递归就会顺着它走进
# sessions root 之外：detector 会读到外面那个目录里的 jsonl，会话列表会把
# 别人的会话内容显示在灵动岛上。这是路径逃逸，不是显示问题。
#
# 这里怎么堵
#
# 1. 不用 AllDirectories。改成自己逐层下钻，每一层只枚举当前层
#    （SearchOption.TopDirectoryOnly）。
# 2. 每进入一个目录之前先看它是不是 reparse point —— 是就不进，也不下钻。
#    逐层下钻的好处是：祖先天然被检查过了（root 到候选路径上的每一级
#    都过了一遍），不需要另写一套祖先检查。
# 3. 每个候选在"打开之前"都要过一遍 containment：它的规范化路径必须
#    仍在规范化 root 之下，且不等于 root 本身。
# 4. 文件本身也查 reparse point —— 一个 jsonl 可以直接是个符号链接。
# 5. 深度上限。junction 可以套 junction，没有上限就会一直往下走。
#
# root 自身是不是 reparse point 不查：那是用户自己挑的目录，他要是把
# sessions 目录做成 junction，那是他的配置，不是逃逸。检查的是 root
# **底下**的那条链。
# ---------------------------------------------------------------------------

# 这个路径（或它指向的东西）是不是 reparse point。
#
# 读不到属性时返回 true：拿不准就当危险，不放行。fail closed。
function Test-PathIsReparsePoint([string]$Path) {
    if (-not $Path) { return $true }
    try {
        $attr = [System.IO.File]::GetAttributes($Path)
        return (($attr -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint)
    } catch {
        return $true
    }
}

# $Candidate 规范化之后，是不是还在 $RootFull 底下。
#
# 前缀比较必须带路径分隔符，否则 C:sessions-evil 会被当成 C:sessions 的
# 子目录。等于 root 本身也不算"在底下"。
function Test-PathContained([string]$RootFull, [string]$Candidate) {
    if (-not $RootFull -or -not $Candidate) { return $false }
    try {
        $c = [System.IO.Path]::GetFullPath($Candidate)
        $r = [System.IO.Path]::GetFullPath($RootFull)
    } catch {
        return $false
    }
    if ($c -eq $r) { return $false }
    $prefix = $r.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    return $c.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

# 在 $Root 下安全地找 $Pattern 匹配的东西。
#
#   -Files    找文件（默认找目录）
#   -Pattern  每一层都用同一个 pattern 过滤，和 EnumerateXxx(root, pat,
#              AllDirectories) 的语义一致：pattern 在每一层都生效。
#   -MaxDepth 最多下钻几层。
#
# 返回一个数组（可能为空）。每个元素都过了两道检查：路径链上没有
# reparse point，且规范化之后仍在 root 之下。
function Get-SafeSessionEntries {
    param(
        [string]$Root,
        [string]$Pattern = '*',
        [switch]$Files,
        [int]$MaxDepth = 16
    )
    $out = New-Object System.Collections.ArrayList
    if (-not $Root) { return $out }
    try { $rootFull = [System.IO.Path]::GetFullPath($Root) } catch { return $out }
    if (-not (Test-Path -LiteralPath $rootFull)) { return $out }

    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([pscustomobject]@{ Path = $rootFull; Depth = 0 })

    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if ($cur.Depth -gt $MaxDepth) { continue }
        $dir = $cur.Path

        if ($Files) {
            try {
                foreach ($f in [System.IO.Directory]::EnumerateFiles($dir, $Pattern, [System.IO.SearchOption]::TopDirectoryOnly)) {
                    if (Test-PathIsReparsePoint $f) { continue }
                    if (-not (Test-PathContained $rootFull $f)) { continue }
                    [void]$out.Add($f)
                }
            } catch { }
        }

        try {
            # 这里枚举的是**全部**子目录，不是匹配 pattern 的那些。
            #
            # pattern 只决定"哪些算结果"，不决定"能不能继续往下走"。
            # EnumerateDirectories(root, '*session_*', AllDirectories) 也会
            # 走遍那些名字不匹配的目录（sessions 树是 <Y>/<M>/<D>/...，
            # 每一层都不叫 session_），只是不把它们当结果返回。按 pattern
            # 过滤后再枚举会把下钻也一起挡掉，整棵树就只剩根目录一层。
            foreach ($d in [System.IO.Directory]::EnumerateDirectories($dir, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
                if (-not (Test-PathContained $rootFull $d)) { continue }
                # reparse point：不收，也不下钻。
                if (Test-PathIsReparsePoint $d) { continue }
                if (-not $Files) {
                    $leaf = [System.IO.Path]::GetFileName($d)
                    if ($leaf -like $Pattern) { [void]$out.Add($d) }
                }
                $queue.Enqueue([pscustomobject]@{ Path = $d; Depth = $cur.Depth + 1 })
            }
        } catch { }
    }
    return $out
}
