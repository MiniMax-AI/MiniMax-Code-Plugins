# scripts/lib/Plan-Usage.ps1
#
# Reads the plan usage that the MiniMax Code runtime already fetched.
#
# The runtime resolves the token plan with the user's own login (the
# "MCode status" panel in the mcode launcher shows it, footer: "Local view
# - credentials hidden") and keeps the numbers in memory. This lib reads the
# same numbers from a local file the runtime writes, so this plugin never
# holds a credential and never makes a request of its own.
#
# # Contract
#
# One JSON object, the same field names the runtime already uses for its
# status panel:
#
#   {
#     "fetchedAtMs": 1792800000000,
#     "fiveHour": { "remainingPercent": 58, "resetAtMs": 1792800000000, "unlimited": false },
#     "weekly":    { "remainingPercent": 40, "resetAtMs": 1792900000000, "unlimited": false },
#     "video":     { "remainingCount": 12, "totalCount": 40 }
#   }
#
# Only "fiveHour" is required; "weekly" and "video" are optional.
#
# # Where the file lives
#
# The canonical path is %APPDATA%\mcode-island\usage.json. The other
# candidates below are read as a fallback so the plugin keeps working if the
# runtime writes to its own data directory instead. MCODE_PLAN_USAGE_FILE
# overrides everything.
#
# # Behaviour
#
# Sets $script:plan5hRemainingPct (0..100, or $null when unknown) and
# $script:plan5hResetMs (milliseconds until the window resets, relative).
# Returns $true when a usable file was read.

$script:planUsageCandidates = @(
  $env:MCODE_PLAN_USAGE_FILE
  (Join-Path $env:APPDATA 'mcode-island\usage.json')
  (Join-Path $env:USERPROFILE '.minimax\usage.json')
)

function Get-PlanUsage {
  $script:plan5hRemainingPct = $null
  $script:plan5hResetMs = $null
  $script:plan5hFromRuntime = $false

  foreach ($candidate in $script:planUsageCandidates) {
    if (-not $candidate) { continue }
    if (-not (Test-Path $candidate)) { continue }
    try {
      $raw = [System.IO.File]::ReadAllText($candidate)
      $data = $raw | ConvertFrom-Json
    } catch {
      continue
    }
    if (-not $data) { continue }

    $five = $null
    if ($data.PSObject.Properties['fiveHour']) { $five = $data.fiveHour }
    if (-not $five) { continue }

    $pct = $null
    if ($five.PSObject.Properties['unlimited'] -and $five.unlimited) {
      # Unlimited means there is no percentage to show. -2 is the widget's
      # "not provided" value, so the badge keeps its time part only.
      $pct = -2
    } elseif ($five.PSObject.Properties['remainingPercent']) {
      $pct = [int]$five.remainingPercent
      if ($pct -lt 0) { $pct = 0 }
      if ($pct -gt 100) { $pct = 100 }
    }

    $resetMs = $null
    if ($five.PSObject.Properties['resetAtMs']) {
      $delta = [long]$five.resetAtMs - [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      if ($delta -gt 0) { $resetMs = $delta }
    }

    $script:plan5hRemainingPct = $pct
    $script:plan5hResetMs = $resetMs
    $script:plan5hFromRuntime = $true
    return $true
  }

  return $false
}
