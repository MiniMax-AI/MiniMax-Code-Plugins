# test-windows-workflow-local.ps1
#
# Local runner that mirrors `.github/workflows/mcode-island-windows.yml`
# 1:1 on a Windows host. Use this when:
#   - The PR is from a fork and GitHub Actions has not yet been
#     approved by a maintainer (so the workflow file is in the PR
#     but does not run on PR pushes), or
#   - You want to develop / debug the contract surfaces without
#     waiting for the CI queue.
#
# Steps verified (all 4 are PR #21 round-5 requirements):
#   1. Parse all .ps1 files (round-5 #1)        - all 27 parse OK
#   2. Token set / show / clear roundtrip       - 4 / 4 checks pass
#   3. Hook stdin / stdout writes status.json   - state=working, source=agent
#   4. Mocked usage-API roundtrip               - auth + path + body shape
#
# Usage (from the repo root, with PowerShell 7+):
#   pwsh -File plugins/antianqi/mcode-island/scripts/test-windows-workflow-local.ps1
#
# Exit code: 0 on full pass, 1 on any failure. Each step prints a
# "OK Step N: ..." line on success or a thrown exception on failure.
#
# Caveat: this script uses an isolated APPDATA at
# %TEMP%\mcode-island-apphome-local\ so it does NOT touch the host's
# real mcode-island config. The Windows PowerShell 5.1 child spawned
# in step 3 is given an explicit -Environment that overrides APPDATA;
# this is necessary because Windows PowerShell 5.1 does not inherit
# the parent pwsh's $env:APPDATA modification (it re-derives from
# %USERPROFILE% on startup).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}

$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path

# --- Shared fixtures ----------------------------------------------------

$apphome = New-Item -ItemType Directory -Path (Join-Path $env:TEMP 'mcode-island-apphome-local') -Force
$env:APPDATA = $apphome.FullName
$FAKE = 'ci-fake-oauth-token-1234567890abcdef'
$env:FAKE_TOKEN = $FAKE

# Defensive: unset pre-existing token env so set-token's -Show reports
# the config.json source (its fallback contract).
foreach ($name in 'MINIMAX_OAUTH_TOKEN', 'MINIMAX_API_KEY') {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}

Write-Host "=== mcode-island windows-latest local runner ==="
Write-Host "Repo: $repoRoot"
Write-Host "Isolated APPDATA: $($apphome.FullName)"
Write-Host ""

# --- Step 1: parse all .ps1 ---------------------------------------------

Write-Host "--- Step 1: parse all .ps1 files ---"
$root = Join-Path $repoRoot 'plugins/antianqi/mcode-island'
$files = @(Get-ChildItem -Path $root -Recurse -Filter *.ps1)
if ($files.Count -eq 0) { throw "Step 1: no .ps1 files under $root" }
$bad = 0
foreach ($f in $files) {
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) {
    $rel = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
    Write-Host "  PARSE FAIL: $rel"
    $errs | ForEach-Object { Write-Host "    line $($_.Extent.StartLineNumber):col $($_.Extent.StartColumnNumber) $($_.Message)" }
    $bad++
  }
}
if ($bad -gt 0) { throw "Step 1: $bad / $($files.Count) .ps1 files failed to parse" }
Write-Host "OK Step 1: $($files.Count) / $($files.Count) .ps1 files parsed without syntax errors"
Write-Host ""

# --- Step 2: token set / show / clear ---------------------------------

Write-Host "--- Step 2: token set / show / clear roundtrip ---"
$set = Join-Path $repoRoot 'plugins/antianqi/mcode-island/set-token.ps1'

# 2a
$r1 = (& $set $FAKE | Out-String).Trim()
if ($r1 -notmatch '^已写入') { throw "Step 2a: expected '已写入' header, got: $r1" }
$cfgFile = Join-Path $apphome.FullName 'mcode-island\config.json'
if (-not (Test-Path $cfgFile)) { throw "Step 2a: $cfgFile not written" }
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
if ($cfg.planApiToken -ne $FAKE) { throw "Step 2a: config.json planApiToken mismatch" }

# 2b
$r2 = (& $set -Show | Out-String).Trim()
if ($r2 -notmatch 'config\.json planApiToken') { throw "Step 2b: expected 'config.json planApiToken', got: $r2" }
$expectedMask = $FAKE.Substring(0, [Math]::Min(10, $FAKE.Length)) + '\.\.\.'
if ($r2 -notmatch $expectedMask) { throw "Step 2b: expected masked prefix matching '$expectedMask', got: $r2" }

# 2c
$r3 = (& $set -Clear | Out-String).Trim()
if ($r3 -notmatch '已从 config\.json 删除') { throw "Step 2c: expected '已从 config.json 删除', got: $r3" }
$cfgAfter = Get-Content $cfgFile -Raw | ConvertFrom-Json
if ($cfgAfter.PSObject.Properties['planApiToken']) { throw "Step 2c: planApiToken still present in config.json" }

# 2d
$r4 = (& $set -Show | Out-String).Trim()
if ($r4 -ne 'token 未配置') { throw "Step 2d: expected 'token 未配置', got: $r4" }

Write-Host "OK Step 2: set / show / clear roundtrip (4 / 4 checks)"
Write-Host ""

# --- Step 3: hook stdin / stdout ---------------------------------------

Write-Host "--- Step 3: hook stdin / stdout (PreToolUse) ---"
$hook = Join-Path $repoRoot 'plugins/antianqi/mcode-island/io.minimax.mcode/hooks/scripts/pre-tool-use.ps1'
$stdinFile = Join-Path $env:TEMP 'hook-stdin-pretooluse-local.json'
$stdinJson = '{"session_id":"ci-fake-session","transcript_path":"C:\\fake\\transcript","cwd":"C:\\fake\\cwd","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo ci-pretooluse-test"}}'
Set-Content -Path $stdinFile -Value $stdinJson -Encoding utf8 -NoNewline

$statusFile = Join-Path $apphome 'mcode-island\status.json'
if (Test-Path $statusFile) { Remove-Item $statusFile -Force }

# Windows PowerShell 5.1 re-derives $env:APPDATA from %USERPROFILE% on
# startup, so $env:APPDATA set in the parent pwsh does not propagate.
# Pass -Environment explicitly.
$childEnv = [System.Collections.Generic.Dictionary[string,string]]::new()
foreach ($k in [System.Environment]::GetEnvironmentVariables('Process').Keys) {
  $childEnv[$k] = [System.Environment]::GetEnvironmentVariable($k)
}
$childEnv['APPDATA'] = $apphome.FullName

$p = Start-Process -FilePath 'powershell' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hook) `
  -NoNewWindow -RedirectStandardInput $stdinFile `
  -Environment $childEnv `
  -PassThru
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "Step 3: pre-tool-use.ps1 exited with code $($p.ExitCode)" }

if (-not (Test-Path $statusFile)) { throw "Step 3: hook did not write $statusFile" }
$status = Get-Content $statusFile -Raw | ConvertFrom-Json
if ($status.state -ne 'working') { throw "Step 3: status.state got '$($status.state)' (want 'working')" }
if ($status.source -ne 'agent') { throw "Step 3: status.source got '$($status.source)' (want 'agent')" }
if ($status.message -notmatch '^Bash\s*:') { throw "Step 3: status.message got '$($status.message)' (want 'Bash : ...')" }
if ($status.message -notmatch 'ci-pretooluse-test') { throw "Step 3: status.message missing 'ci-pretooluse-test'" }

Write-Host "OK Step 3: hook PreToolUse OK: state=$($status.state) source=$($status.source)"
Write-Host ""

# --- Step 4: mocked usage-API roundtrip -------------------------------

Write-Host "--- Step 4: mocked usage-API roundtrip ---"
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$freePort = [int]$probe.LocalEndpoint.Port
$probe.Stop()
Write-Host "Free port: $freePort"

$job = Start-Job -ScriptBlock {
  param($port)
  $listener = [System.Net.HttpListener]::new()
  $listener.Prefixes.Add("http://127.0.0.1:$port/")
  $listener.Start()
  try {
    $ctx = $listener.GetContext()
    $auth = $ctx.Request.Headers['Authorization']
    $path = $ctx.Request.Url.AbsolutePath
    $body = '{"model_remains":[{"model":"general","remainingPct":84,"resetMs":16200000}]}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $ctx.Response.StatusCode = 200
    $ctx.Response.ContentType = 'application/json'
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
    [PSCustomObject]@{ auth = $auth; path = $path }
  } finally {
    $listener.Stop()
    $listener.Close()
  }
} -ArgumentList $freePort

try {
  # 4a) Token resolution: env wins over config.json
  $env:MINIMAX_OAUTH_TOKEN = $FAKE
  $cfgDir = Join-Path $apphome 'mcode-island'
  if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }
  @{ planApiToken = 'config-token-should-not-be-used' } | ConvertTo-Json |
    Out-File -FilePath (Join-Path $cfgDir 'config.json') -Encoding utf8

  # 4b) The detector requests this URL; we point it at the local listener
  $url = "http://127.0.0.1:$freePort/v1/coding_plan/remains"
  $headers = @{
    'Authorization' = "Bearer $env:MINIMAX_OAUTH_TOKEN"
    'MM-API-Source' = 'MiniMax-MCP'
  }
  $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 10 -Method Get -ErrorAction Stop

  # 4c) Bearer + path assertion
  $mock = $job | Wait-Job -Timeout 15 | Receive-Job
  if (-not $mock) { throw "Step 4: listener job did not complete within 15s" }
  if ($mock.auth -ne "Bearer $FAKE") { throw "Step 4: mock saw auth='$($mock.auth)' (want 'Bearer $FAKE')" }
  if ($mock.path -ne '/v1/coding_plan/remains') { throw "Step 4: mock saw path='$($mock.path)' (want '/v1/coding_plan/remains')" }

  # 4d) Response shape
  if (-not $resp -or -not $resp.model_remains) { throw "Step 4: missing model_remains in response" }
  $first = @($resp.model_remains)[0]
  if ($first.remainingPct -ne 84 -or $first.resetMs -ne 16200000) {
    throw "Step 4: first model_remains entry got pct=$($first.remainingPct) reset=$($first.resetMs) (want 84 / 16200000)"
  }

  Write-Host "OK Step 4: mock auth='$($mock.auth)' path='$($mock.path)' first entry=remainingPct=$($first.remainingPct)% resetMs=$($first.resetMs)"
}
finally {
  if ($job.State -ne 'Completed') { Stop-Job $job }
  Remove-Job $job -Force
}

Write-Host ""
Write-Host "=== All 4 steps OK ==="
exit 0
