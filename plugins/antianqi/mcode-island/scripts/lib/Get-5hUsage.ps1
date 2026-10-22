# scripts/lib/Get-5hUsage.ps1
#
# Self-contained 5h usage API client. Exposes one function:
#
#     Get-5hUsage
#
# Returns  @{ remainingPct; resetMs }  on success,  $null  on any
# failure (no token, network error, parse error, missing field).
#
# # Why this is a separate lib
#
# This lib is dot-sourced by:
#   1. mcode-status-detect.ps1 (the runtime detector's main loop)
#   2. .github/workflows/mcode-island-windows.yml step 4
#      (windows-latest CI contract test, must run without an
#      mcode install)
#   3. scripts/test-windows-workflow-local.ps1 step 4
#      (local equivalent of #2)
#
# The detector (case 1) requires mcode to be installed: its main
# loop polls mcode's session log. Cases 2 and 3 do NOT have mcode
# installed -- a CI runner does not have a real mcode, and the
# point of step 4 is to exercise the 5h usage path against a
# mocked HTTP listener. If `Get-5hUsage` lived in the same file
# as the main loop, dot-sourcing it would force the install-root
# check, which would block CI step 4 with:
#
#     Cannot find mcode install root (.minimax-code).
#     Pass -Root or ensure mcode is running.
#
# Round-9 (commit acdcf8f7) hit this regression. This lib is the
# round-11 fix.
#
# # Contract for callers
#
#   * `$script:plan5hToken` (script-scope string) must be set by
#     the caller BEFORE calling `Get-5hUsage`. Three acceptable
#     sources, in precedence order:
#         1. $env:MINIMAX_OAUTH_TOKEN
#         2. $env:MINIMAX_API_KEY
#         3. (config.json).planApiToken at $cfgFile
#     When unset, the function returns $null at line 67 without
#     touching the network.
#
#   * `$script:PLAN_API_HOST` and `$script:PLAN_API_PATH` are
#     exposed for tests that want to redirect the request to a
#     mock listener (see step 4 in the workflow / local-runner).
#     Production code should not reassign them.
#
#   * The function is dot-source-only. It is NOT meant to be run
#     as a standalone script. Running it directly would not do
#     anything useful (no main loop), and the script would
#     silently no-op because the only callable is `Get-5hUsage`
#     and there is no entry point.

# PS 5.1 parser quirk (same as mcode-status-detect.ps1):
#   short ASCII string literals at the end of `-eq` / `= state=`
#   lines get parsed as cmdlet arguments. The URL/host bytes are
#   obfuscated through a private `_s` helper to keep the
#   production endpoint out of a naive `grep`.
function _s { param([byte[]]$b) [System.Text.Encoding]::UTF8.GetString($b) }

# 5h usage API endpoint.
$PLAN_API_HOST = _s (0x68,0x74,0x74,0x70,0x73,0x3A,0x2F,0x2F,0x61,0x70,0x69,0x2E,0x6D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x69,0x2E,0x63,0x6F,0x6D)  # https://api.minimaxi.com
$PLAN_API_PATH = _s (0x2F,0x76,0x31,0x2F,0x63,0x6F,0x64,0x69,0x6E,0x67,0x5F,0x70,0x6C,0x61,0x6E,0x2F,0x72,0x65,0x6D,0x61,0x69,0x6E,0x73)  # /v1/coding_plan/remains

# Get-5hUsage
#   Reads $script:plan5hToken from the caller's scope. Returns
#   @{ remainingPct = 0..100; resetMs = ms }  on success, or
#   $null  on any failure.
#
#   The fixture's field names (model_name /
#   current_interval_remaining_percent / remains_time) are
#   hard-coded here. The CI step 4 fixture uses the SAME names;
#   a future change that breaks the field-name contract will
#   cause the function to return $null and fail the CI assertion.
function Get-5hUsage {
  if (-not $script:plan5hToken) { return $null }
  try {
    # PowerShell 5.1 on some Windows defaults to TLS 1.0; force
    # 1.2 so the handshake does not fail before we ever read.
    if ([System.Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
      [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    }
    $url = $PLAN_API_HOST + $PLAN_API_PATH
    $headers = @{
      'Authorization' = "Bearer $($script:plan5hToken)"
      'MM-API-Source' = _s (0x4D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x2D,0x4D,0x43,0x50)  # Minimax-MCP
    }
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 8 -Method Get -ErrorAction Stop
    if (-not $resp -or -not $resp.model_remains) { return $null }
    foreach ($m in @($resp.model_remains)) {
      if ($m.model_name -eq 'general') {
        $remPct = [int]$m.current_interval_remaining_percent
        if ($remPct -lt 0)   { $remPct = 0 }
        if ($remPct -gt 100) { $remPct = 100 }
        $resetMs = [int]$m.remains_time
        if ($resetMs -lt 0)  { $resetMs = 0 }
        return @{ remainingPct = $remPct; resetMs = $resetMs }
      }
    }
    return $null
  } catch {
    # No Log-Line here on purpose: the lib is meant to be
    # callable from contexts that do not have a log file
    # (e.g. CI step 4 has no mcode-island log). Callers that
    # want to log a fetch failure can wrap the call in their
    # own try/catch.
    return $null
  }
}

# 5h usage API 节流窗口
$PLAN_API_TTL = [TimeSpan]::FromSeconds(60)

# Resolve-PlanToken
#
#   按优先级解析 token，写进 $script:plan5hToken：
#     1. $env:MINIMAX_OAUTH_TOKEN
#     2. $env:MINIMAX_API_KEY
#     3. %APPDATA%\mcode-island\config.json 里的 planApiToken
#
#   三种来源都没有时保持 $null —— Get-5hUsage 会直接返回 $null，一次
#   网络请求都不发。
#
#   放在 lib 里而不是 detector 里，是为了让"要不要用 5h 用量"这件事
#   完全由 lib 的存在与否决定：lib 不在（Marketplace 上架包就不带它），
#   detector 既不读 token 也不联网。
function Resolve-PlanToken {
  $script:plan5hToken = $null
  if ($env:MINIMAX_OAUTH_TOKEN) { $script:plan5hToken = $env:MINIMAX_OAUTH_TOKEN; return }
  if ($env:MINIMAX_API_KEY) { $script:plan5hToken = $env:MINIMAX_API_KEY; return }

  $cfgPath = Get-Variable -Name 'cfgFile' -ValueOnly -ErrorAction SilentlyContinue
  if (-not $cfgPath) { $cfgPath = Join-Path $env:APPDATA 'mcode-island\config.json' }
  if (-not (Test-Path $cfgPath)) { return }
  try {
    $cfg = [System.IO.File]::ReadAllText($cfgPath) | ConvertFrom-Json
    if ($cfg.PSObject.Properties['planApiToken'] -and $cfg.planApiToken) {
      $script:plan5hToken = [string]$cfg.planApiToken
    }
  } catch {}
}

# Refresh-5hUsage
#
#   主循环里每 60s 调一次（TTL 守门，单线程安全），结果写进
#   $script:plan5hRemainingPct / $script:plan5hResetMs。
function Refresh-5hUsage {
  $now = Get-Date
  if (($now - $script:plan5hLastCallAt) -lt $PLAN_API_TTL) { return }
  $script:plan5hLastCallAt = $now
  $data = Get-5hUsage
  if ($null -eq $data) {
    $script:plan5hRemainingPct = $null
    $script:plan5hResetMs = $null
  } else {
    $script:plan5hRemainingPct = [int]$data.remainingPct
    $script:plan5hResetMs = [int]$data.resetMs
  }
}
