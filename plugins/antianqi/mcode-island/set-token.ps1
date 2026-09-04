# mcode-island - 设置 5h 用量 API token
# 用法：
#   set-token.ps1 <token>           # 写 token 到 %APPDATA%\mcode-island\config.json
#   set-token.ps1 -Show             # 显示当前是否已配置
#   set-token.ps1 -Clear            # 删除 token
#
# token 也可以从环境变量 MINIMAX_OAUTH_TOKEN 自动读，优先级：
#   1. $env:MINIMAX_OAUTH_TOKEN
#   2. $env:MINIMAX_API_KEY
#   3. config.json 的 planApiToken
# 所以通常不用手动 set-token，除非要换 token。

param(
  [Parameter(Position=0)]
  [string]$Token,
  [switch]$Show,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $cfgDir)) { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }
$cfgFile = Join-Path $cfgDir 'config.json'

function Read-Cfg {
  if (Test-Path $cfgFile) {
    try { return (Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch {}
  }
  return [PSCustomObject]@{}
}

function Write-Cfg($obj) {
  $obj | ConvertTo-Json | Out-File -FilePath $cfgFile -Encoding UTF8
}

if ($Show) {
  $cfg = Read-Cfg
  $hasCfg = $cfg.PSObject.Properties['planApiToken'] -and $cfg.planApiToken
  $hasEnv = $env:MINIMAX_OAUTH_TOKEN -or $env:MINIMAX_API_KEY
  if ($hasEnv) {
    $src = if ($env:MINIMAX_OAUTH_TOKEN) { 'env:MINIMAX_OAUTH_TOKEN' } else { 'env:MINIMAX_API_KEY' }
    Write-Output "token 来源: $src"
  } elseif ($hasCfg) {
    $masked = $cfg.planApiToken.Substring(0, [Math]::Min(10, $cfg.planApiToken.Length)) + '...'
    Write-Output "token 来源: config.json planApiToken ($masked)"
  } else {
    Write-Output "token 未配置"
  }
  exit 0
}

if ($Clear) {
  $cfg = Read-Cfg
  if ($cfg.PSObject.Properties['planApiToken']) {
    $cfg.PSObject.Properties.Remove('planApiToken')
    Write-Cfg $cfg
    Write-Output '已从 config.json 删除 planApiToken'
  } else {
    Write-Output 'config.json 没有 planApiToken，无需删除'
  }
  exit 0
}

if (-not $Token) {
  Write-Output '用法: set-token.ps1 <token> | -Show | -Clear'
  exit 1
}

$cfg = Read-Cfg
if ($cfg.PSObject.Properties['planApiToken']) {
  $cfg.planApiToken = $Token
} else {
  $cfg | Add-Member -NotePropertyName 'planApiToken' -NotePropertyValue $Token
}
Write-Cfg $cfg
$masked = $Token.Substring(0, [Math]::Min(10, $Token.Length)) + '...'
Write-Output "已写入 $cfgFile"
Write-Output "  planApiToken: $masked"
Write-Output '重启 detector 后生效: mcode-island detect-off && mcode-island detect-on'
