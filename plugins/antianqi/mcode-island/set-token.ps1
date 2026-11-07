# mcode-island - 设置 5h 用量 API token
# 用法：
#   set-token.ps1 <token>           # 加密保存 token 到 %APPDATA%\mcode-island\config.json
#   set-token.ps1 -Show             # 显示当前 token 的来源
#   set-token.ps1 -Clear            # 删除 token
#   set-token.ps1 -AllowEnvToken    # 允许从环境变量读 token（显式授权）
#   set-token.ps1 -NoEnvToken       # 禁止从环境变量读 token（默认）
#
# token 的存放方式：
#   config.json 的 planApiTokenEnc —— 用 Windows DPAPI（CurrentUser 作用域）
#   加密后的 base64。同一个 Windows 用户、同一台机器才能解开；拷到别处没用。
#
# 环境变量（MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY）默认**不读**：
#   环境里恰好有个变量，不等于同意把它发到接口上。要用就显式开一次：
#     set-token.ps1 -AllowEnvToken
#   写进 config.json 的 allowEnvToken=true。
#
# 旧版本把 token 明文写在 config.json 的 planApiToken 里。现在读到旧格式
# 会自动就地迁移成加密格式，明文当场删掉，不用手动处理。

param(
  [Parameter(Position=0)]
  [string]$Token,
  [switch]$Show,
  [switch]$Clear,
  [switch]$AllowEnvToken,
  [switch]$NoEnvToken
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $cfgDir)) { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }
$cfgFile = Join-Path $cfgDir 'config.json'

. "$PSScriptRoot/scripts/lib/Protect-Token.ps1"

function Read-Cfg {
  if (Test-Path $cfgFile) {
    try { return ([System.IO.File]::ReadAllText($cfgFile) | ConvertFrom-Json) } catch {}
  }
  return [PSCustomObject]@{}
}

function Write-Cfg($obj) {
  # 原子替换：config.json 里存着 token，写到一半失败会把 token 弄丢。
  Write-AtomicText -Path $cfgFile -Content ($obj | ConvertTo-Json -Depth 10)
}

function Set-CfgProp($cfg, [string]$name, $value) {
  if ($cfg.PSObject.Properties[$name]) { $cfg.$name = $value }
  else { $cfg | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

if ($Show) {
  $cfg = Read-Cfg
  $hasEnc = $cfg.PSObject.Properties['planApiTokenEnc'] -and $cfg.planApiTokenEnc
  $hasLegacy = $cfg.PSObject.Properties['planApiToken'] -and $cfg.planApiToken
  $envAllowed = $cfg.PSObject.Properties['allowEnvToken'] -and $cfg.allowEnvToken
  $hasEnv = $env:MINIMAX_OAUTH_TOKEN -or $env:MINIMAX_API_KEY

  if ($hasEnc) {
    $plain = Unprotect-Token ([string]$cfg.planApiTokenEnc)
    $masked = if ($plain) { $plain.Substring(0, [Math]::Min(10, $plain.Length)) + '...' } else { '(无法解密)' }
    Write-Output "token 来源: config.json planApiTokenEnc (DPAPI 加密, $masked)"
  } elseif ($hasLegacy) {
    Write-Output "token 来源: config.json planApiToken (旧版明文，下次启动 detector 时自动迁移成密文)"
  } elseif ($envAllowed -and $hasEnv) {
    $src = if ($env:MINIMAX_OAUTH_TOKEN) { 'env:MINIMAX_OAUTH_TOKEN' } else { 'env:MINIMAX_API_KEY' }
    Write-Output "token 来源: $src (已通过 -AllowEnvToken 授权)"
  } elseif ($envAllowed) {
    Write-Output "token 来源: 未配置（已允许读环境变量，但环境里没有 MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY）"
  } elseif ($hasEnv) {
    Write-Output "token 未配置（环境里存在 MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY，但没有用 -AllowEnvToken 授权，所以不读）"
  } else {
    Write-Output "token 未配置"
  }
  exit 0
}

if ($Clear) {
  $cfg = Read-Cfg
  $changed = $false
  foreach ($name in @('planApiTokenEnc', 'planApiToken')) {
    if ($cfg.PSObject.Properties[$name]) { $cfg.PSObject.Properties.Remove($name); $changed = $true }
  }
  if ($changed) {
    Write-Cfg $cfg
    Write-Output '已从 config.json 删除 token'
  } else {
    Write-Output 'config.json 没有 token，无需删除'
  }
  exit 0
}

if ($AllowEnvToken -or $NoEnvToken) {
  $cfg = Read-Cfg
  Set-CfgProp $cfg 'allowEnvToken' ([bool]$AllowEnvToken)
  Write-Cfg $cfg
  if ($AllowEnvToken) {
    Write-Output '已允许从环境变量 MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY 读取 token'
  } else {
    Write-Output '已禁止从环境变量读取 token'
  }
  Write-Output '重启 detector 后生效: mcode-island detect-off && mcode-island detect-on'
  exit 0
}

if (-not $Token) {
  Write-Output '用法: set-token.ps1 <token> | -Show | -Clear | -AllowEnvToken | -NoEnvToken'
  exit 1
}

if (-not (Test-TokenProtection)) {
  Write-Output '这台机器上的 PowerShell 没有可用的 DPAPI，token 只能以明文存放。'
  Write-Output '为避免明文落盘，这里不做任何写入。'
  exit 1
}

$enc = Protect-Token $Token
if (-not $enc) {
  Write-Output 'DPAPI 加密失败，没有写入任何内容。'
  exit 1
}

$cfg = Read-Cfg
# 旧版明文字段顺手清掉
if ($cfg.PSObject.Properties['planApiToken']) { $cfg.PSObject.Properties.Remove('planApiToken') }
Set-CfgProp $cfg 'planApiTokenEnc' $enc
Write-Cfg $cfg
$masked = $Token.Substring(0, [Math]::Min(10, $Token.Length)) + '...'
Write-Output "已写入 $cfgFile"
Write-Output "  planApiTokenEnc: $masked (DPAPI 加密)"
Write-Output '重启 detector 后生效: mcode-island detect-off && mcode-island detect-on'
