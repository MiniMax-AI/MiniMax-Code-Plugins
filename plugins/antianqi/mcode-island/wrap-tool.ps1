# mcode 灵动岛 - 工具调用 wrapper (v0.2.1: status-only)
# 用法（在 mcode 里）：
#   wrap-tool.ps1 -Tool bash -Command "npm test"                # 推 working
#   wrap-tool.ps1 -Tool bash -Command "npm test" -ExitCode 0    # 推 done
#   wrap-tool.ps1 -Tool bash -Command "npm test" -ExitCode 1    # 推 waiting
#   wrap-tool.ps1 -Tool bash -Command "npm test" -ExitCode 2    # 推 error
#
# 设计：v0.2.1 改为"只发通知不执行命令"。v0.1 的 Invoke-Expression 在 review 中
# 被指出 injection 风险（任意 PS 代码执行）。现在 agent 自己在 mcode bash tool
# 里跑命令，然后调本脚本只发状态，shell 边界由 mcode 自己处理。
#
# 行为：
#   1. 推 working -Message "<Tool> <brief>"        （如果没传 -ExitCode）
#   2. 推 done/error/waiting based on -ExitCode    （如果传了 -ExitCode）
#   3. 退出码原样返回（done→0, waiting→waiting-exit-code, error→error-exit-code）

param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('bash','read','write','edit','glob','grep','web','task','notebook')]
  [string]$Tool,

  [string]$Command = '',
  [string]$Path = '',
  [string]$Pattern = '',
  [string]$Glob = '',
  [string]$Description = '',
  [int]$ExitCode = -1,                      # -1 = not yet run, push working; 0/非0 = push done/waiting/error
  [int[]]$WaitingExitCodes = @(1)           # 这些退出码视为 "waiting"（需要审批）
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

$notify = Join-Path $PSScriptRoot 'notify-island.ps1'

# 拼一个"简述"显示在 widget 上
$brief = $Description
if (-not $brief) {
  if ($Command) { $brief = ($Command.Substring(0, [Math]::Min(60, $Command.Length))) }
  elseif ($Path) { $brief = $Path }
  elseif ($Pattern) { $brief = $Pattern }
  elseif ($Glob) { $brief = $Glob }
  else { $brief = '' }
}
$brief = $brief -replace "`r`n", ' ' -replace "`n", ' '

if ($ExitCode -lt 0) {
  # 还没跑完：推 working
  & $notify -State working -Message "$Tool : $brief" | Out-Null
  exit 0
}

# 跑完了：根据退出码推 done/waiting/error
if ($ExitCode -eq 0) {
  & $notify -State done -Message "$Tool 完成" | Out-Null
  exit 0
} elseif ($WaitingExitCodes -contains $ExitCode) {
  & $notify -State waiting -Message "$Tool 等待审批 (exit=$ExitCode)" | Out-Null
  exit $ExitCode
} else {
  & $notify -State error -Message "$Tool 失败 (exit=$ExitCode)" | Out-Null
  exit $ExitCode
}
