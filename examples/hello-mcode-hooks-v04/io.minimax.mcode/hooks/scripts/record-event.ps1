# record-event.ps1
#
# Observer hook script for the mcode 0.4.0+ inline hook format. Reads one JSON
# event payload from stdin (the runtime delivers one document, then EOF), and
# appends a compact record to ${PLUGIN_DATA}/state.json using a staging-file
# rename so the file is never torn.
#
# The script is observe-only. It does not modify tool input, does not change
# permission decisions, does not access the network, and does not write outside
# ${PLUGIN_DATA}. The exit code is always 0 on every code path; non-zero would
# be treated as "no opinion" by the runtime and would skip the side effect.
#
# The script is a structural reference for new Plugin authors. It is not a
# working integration; the runtime only delivers this script's stdin when a
# matching event fires in the host Agent.

$ErrorActionPreference = 'Stop'

$pluginData = $env:PLUGIN_DATA
if ([string]::IsNullOrEmpty($pluginData)) {
    # No runtime-injected data directory. Nothing to do. Exit zero.
    exit 0
}

# Read the full stdin (one JSON document, then EOF). Use [Console]::In so the
# read is synchronous and does not depend on pipeline encoding.
$payload = ''
try {
    $payload = [Console]::In.ReadToEnd()
} catch {
    # stdin unavailable; treat as an empty payload and still exit zero.
    $payload = ''
}

# Parse the payload if it looks like JSON; otherwise treat as opaque text.
$parsed = $null
if (-not [string]::IsNullOrWhiteSpace($payload)) {
    try {
        $parsed = $payload | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $parsed = $null
    }
}

$eventName = 'Unknown'
$sessionId = ''
$toolName = ''
if ($null -ne $parsed) {
    if ($parsed.PSObject.Properties.Match('hook_event_name').Count -gt 0 -and $null -ne $parsed.hook_event_name) {
        $eventName = [string]$parsed.hook_event_name
    } elseif ($parsed.PSObject.Properties.Match('event').Count -gt 0 -and $null -ne $parsed.event) {
        $eventName = [string]$parsed.event
    }
    if ($parsed.PSObject.Properties.Match('session_id').Count -gt 0 -and $null -ne $parsed.session_id) {
        $sessionId = [string]$parsed.session_id
    }
    if ($parsed.PSObject.Properties.Match('tool_name').Count -gt 0 -and $null -ne $parsed.tool_name) {
        $toolName = [string]$parsed.tool_name
    }
}

# Build the record. One JSON object per line in state.json so the file is
# append-only and re-parseable.
$record = [ordered]@{
    ts = (Get-Date).ToUniversalTime().ToString('o')
    event = $eventName
    session_id = $sessionId
    tool_name = $toolName
}
$recordJson = ($record | ConvertTo-Json -Compress -Depth 5)

# Ensure the data directory exists.
try {
    if (-not (Test-Path -LiteralPath $pluginData -PathType Container)) {
        New-Item -ItemType Directory -Path $pluginData -Force | Out-Null
    }
} catch {
    exit 0
}

$stateFile = Join-Path -Path $pluginData -ChildPath 'state.json'
$stagingFile = "$stateFile.staging"

# Read the existing content (one JSON object per line); tolerate missing or
# corrupt files by starting fresh.
$existing = ''
try {
    if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
        $existing = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8
    }
} catch {
    $existing = ''
}

# Atomic write: write to staging, then rename. Rename on Windows is atomic
# within the same volume, so a concurrent reader never sees a torn file.
try {
    $newContent = if ([string]::IsNullOrEmpty($existing)) { $recordJson } else { $existing + "`n" + $recordJson }
    [System.IO.File]::WriteAllText($stagingFile, $newContent, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $stagingFile -Destination $stateFile -Force
} catch {
    # Best-effort cleanup of the staging file on failure.
    try { Remove-Item -LiteralPath $stagingFile -Force -ErrorAction SilentlyContinue } catch { }
    exit 0
}

exit 0
