# mcode 灵动岛 - 工具调用 wrapper
# 用法（在 mcode 里）：
#   wrap-tool.ps1 -Tool "bash" -Command "npm test"
#   wrap-tool.ps1 -Tool "read"  -Path "C:\foo.txt"
#   wrap-tool.ps1 -Tool "write" -Path "..." -Command "..."
#   wrap-tool.ps1 -Tool "edit"  -Path "..." -Command "..."
#
# 行为：
#   1. 推 working -Message "<Tool> <brief>"
#   2. 执行命令
#   3. 根据退出码推 done (0) / error (≠0) / waiting (特殊)
#   4. 退出码原样返回（不吞）

param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('bash','read','write','edit','glob','grep','web','task','notebook')]
  [string]$Tool,

  [string]$Command = '',
  [string]$Path = '',
  [string]$Pattern = '',
  [string]$Glob = '',
  [string]$Description = '',
  [int[]]$WaitingExitCodes = @(1)   # 这些退出码视为 "waiting"（需要审批）
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

$notify = Join-Path $PSScriptRoot 'notify-island.ps1'

# 1) 拼一个"简述"显示在 widget 上
$brief = $Description
if (-not $brief) {
  if ($Command) { $brief = ($Command.Substring(0, [Math]::Min(60, $Command.Length))) }
  elseif ($Path) { $brief = $Path }
  elseif ($Pattern) { $brief = $Pattern }
  elseif ($Glob) { $brief = $Glob }
  else { $brief = '' }
}
$brief = $brief -replace "`r`n", ' ' -replace "`n", ' '

# 2) 推 working
& $notify -State working -Message "$Tool : $brief" | Out-Null

# 3) 执行命令（这里只支持 bash，其他工具类型让外层 PS 直接处理）
$exitCode = 0
$timedOut = $false

try {
  if ($Tool -eq 'bash') {
    if (-not $Command) { Write-Error "bash 工具需要 -Command"; exit 2 }
    # 用 Out-Default 让 stdout 流到 mcode 的终端
    Invoke-Expression $Command
    $exitCode = $LASTEXITCODE
    if (-not $exitCode) { $exitCode = 0 }
  } else {
    # 其他工具：直接交给外层 PS 执行（这个 wrapper 设计上不接管）
    Write-Warning "wrap-tool: '$Tool' 类型请在调用方直接处理，wrapper 不接管"
    & $notify -State error -Message "$Tool : wrapper 不支持此类工具" | Out-Null
    exit 2
  }
} catch {
  Write-Output ("[wrap-tool error] " + $_.Exception.Message)
  & $notify -State error -Message "$Tool : 异常" | Out-Null
  exit 99
}

# 4) 根据退出码推状态
if ($exitCode -eq 0) {
  & $notify -State done -Message "$Tool 完成" | Out-Null
} elseif ($WaitingExitCodes -contains $exitCode) {
  & $notify -State waiting -Message "$Tool 等待审批 (exit=$exitCode)" | Out-Null
} else {
  & $notify -State error -Message "$Tool 失败 (exit=$exitCode)" | Out-Null
}

exit $exitCode
