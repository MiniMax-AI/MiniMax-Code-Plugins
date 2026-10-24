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
#     the caller BEFORE calling `Get-5hUsage`. `Resolve-PlanToken`
#     (below) does that for the detector. Two acceptable sources:
#         1. config.json -> planApiTokenEnc, the DPAPI-encrypted blob
#         2. $env:MINIMAX_OAUTH_TOKEN / $env:MINIMAX_API_KEY, and only
#            when the user has explicitly opted in with
#            `set-token.ps1 -AllowEnvToken` (config.json ->
#            allowEnvToken). An ambient environment variable is not
#            consent to send it to an API.
#     When unset, the function returns $null without touching the network.
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

# 5h usage API endpoint.
#
# Plain text on purpose: the endpoint used to be assembled from a byte
# array so that a naive `grep` for the host would not find it. That is
# indistinguishable from hiding a string from review, and it made the
# disclosure in README.md unverifiable. The endpoint is the user's own
# MiniMax account endpoint and is named in the README, so it is written
# out.
$PLAN_API_HOST = 'https://api.minimaxi.com'
$PLAN_API_PATH = '/v1/coding_plan/remains'

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
    # Only the Authorization header. The endpoint identifies the
    # credential, not the client: a probe without any header, with
    # "MM-API-Source: Minimax-MCP" and with "MM-API-Source: mcode-island"
    # all return the same 1004 "Please carry the API secret key in the
    # 'Authorization' field", so the source header was never read. It
    # only claimed to be a MiniMax-owned surface, which it is not.
    $headers = @{
      'Authorization' = "Bearer $($script:plan5hToken)"
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
#   解析 token，写进 $script:plan5hToken。优先级：
#     1. config.json 的 planApiTokenEnc（DPAPI 加密，CurrentUser 作用域）
#     2. 环境变量 MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY
#        —— 只有用户在 config.json 里显式 allowEnvToken=true 时才读。
#           环境里恰好有变量不等于同意把它发出去。
#     3. 旧版本留下的明文 config.json:planApiToken
#        —— 读到的同时就地迁移成加密形式，明文当场删除。
#
#   三种来源都没有时保持 $null —— Get-5hUsage 会直接返回 $null，一次
#   网络请求都不发。
#
#   放在 lib 里而不是 detector 里，是为了让"要不要用 5h 用量"这件事
#   完全由 lib 的存在与否决定：lib 不在（Marketplace 上架包就不带它），
#   detector 既不读 token 也不联网。
. "$PSScriptRoot/Protect-Token.ps1"

function Resolve-PlanToken {
  $script:plan5hToken = $null

  $cfgPath = Get-Variable -Name 'cfgFile' -ValueOnly -ErrorAction SilentlyContinue
  if (-not $cfgPath) { $cfgPath = Join-Path $env:APPDATA 'mcode-island\config.json' }

  $cfg = $null
  if (Test-Path $cfgPath) {
    try { $cfg = [System.IO.File]::ReadAllText($cfgPath) | ConvertFrom-Json } catch { $cfg = $null }
  }

  # 1) DPAPI 加密的 token
  if ($cfg -and $cfg.PSObject.Properties['planApiTokenEnc'] -and $cfg.planApiTokenEnc) {
    $plain = Unprotect-Token ([string]$cfg.planApiTokenEnc)
    if ($plain) { $script:plan5hToken = $plain; return }
  }

  # 2) 环境变量：必须用户显式开过
  if ($cfg -and $cfg.PSObject.Properties['allowEnvToken'] -and $cfg.allowEnvToken) {
    if ($env:MINIMAX_OAUTH_TOKEN) { $script:plan5hToken = $env:MINIMAX_OAUTH_TOKEN; return }
    if ($env:MINIMAX_API_KEY) { $script:plan5hToken = $env:MINIMAX_API_KEY; return }
  }

  # 3) 旧版明文 token：就地迁移成密文
  if ($cfg -and $cfg.PSObject.Properties['planApiToken'] -and $cfg.planApiToken) {
    $legacy = [string]$cfg.planApiToken
    $script:plan5hToken = $legacy
    $enc = Protect-Token $legacy
    if ($enc) {
      try {
        $cfg.PSObject.Properties.Remove('planApiToken')
        $cfg | Add-Member -NotePropertyName 'planApiTokenEnc' -NotePropertyValue $enc -Force
        # 原子替换：先写新文件，再换名。直接 WriteAllText 的话，中途失败
        # 会把 config.json 截断，用户的 token 就没了。
        Write-AtomicText -Path $cfgPath -Content ($cfg | ConvertTo-Json -Depth 10)
      } catch {}
    }
  }
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
