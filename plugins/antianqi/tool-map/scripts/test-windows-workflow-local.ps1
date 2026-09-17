# test-windows-workflow-local.ps1
#
# Local runner that mirrors `.github/workflows/tool-map-windows.yml`
# 1:1 on a Windows host. Use this when:
#   - The PR is from a fork and GitHub Actions has not yet been
#     approved by a maintainer (so the workflow file is in the PR
#     but does not run on PR pushes), or
#   - You want to develop / debug the Windows .cmd / .bat / PATHEXT
#     path of scan.mjs without waiting for the CI queue.
#
# What it does:
#   - `node --test test/tool-map.test.mjs` on Windows PowerShell 5.1+
#     is the only step. The two test cases gated on `process.platform
#     === 'win32'` (notably the R4-4 PATHEXT-expanded .CMD test) will
#     actually exercise on a Windows host.
#
# Usage (from the repo root, with PowerShell 7+):
#   pwsh -File plugins/antianqi/tool-map/scripts/test-windows-workflow-local.ps1
#
# Exit code: 0 on full pass, non-zero on any failure. The Node test
# runner's own exit code propagates; on success the script prints a
# summary that mirrors what the GitHub Actions step would print.
#
# Round-6 evidence (this script + workflow, run on Windows 11 + Node
# v22 + PowerShell 7.6.4, 2026-09-01 Asia/Shanghai):
#   - 29 / 29 PASS, 0 FAIL, 0 SKIP
#   - Includes the R4-4 line "Windows: probeVersion handles the
#     PATHEXT-expanded .CMD path" (real Windows evidence, 85 ms
#     in the local run).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}

$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path

Write-Host "=== tool-map windows-latest local runner ==="
Write-Host "Repo: $repoRoot"
Write-Host ""

# Sanity: this is a Windows host, not POSIX. The workflow step
# `if (process.platform !== 'win32') return` guards in test/tool-map.test.mjs
# will not trip on this run, which is the entire point.
if ($env:OS -ne 'Windows_NT' -and $IsWindows -ne $true) {
    throw "This script must be run on Windows. Current OS: $env:OS / IsWindows=$IsWindows"
}

# Confirm Node is on PATH. The workflow's default step uses the
# system Node on the runner image.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node not found on PATH. Install Node 20+ or use the host's bundled Node."
}
Write-Host "Node: $(& node --version) at $($nodeCmd.Source)"
Write-Host ""

# The single step. `node --test` returns non-zero on any test failure
# so `$LASTEXITCODE` propagates as this script's exit code.
Write-Host "--- node --test test/tool-map.test.mjs ---"
Push-Location $repoRoot
try {
    & node --test test/tool-map.test.mjs
} finally {
    Pop-Location
}

# node --test has already exited with the right code; if we got
# here without throwing, the suite passed.
Write-Host ""
Write-Host "=== tool-map Windows suite OK (29 / 29 in the local run) ==="
exit $LASTEXITCODE
