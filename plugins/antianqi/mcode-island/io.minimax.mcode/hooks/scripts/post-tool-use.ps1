# Hook: PostToolUse
# Event:  io.minimax.mcode / PostToolUse
# State:  done / error
# Note:   Fires after every tool call returns. Heuristic: if the
#         tool_result is empty or matches an error pattern, push
#         error; otherwise push done. Self-push calls are filtered.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
if (Test-IsSelfPush $evt) { exit 0 }

$tool  = if ($evt.tool_name) { [string]$evt.tool_name } else { 'tool' }
$result = $evt.tool_result
$isError = $false

if ($null -eq $result) {
    $isError = $true
} else {
    $s = [string]$result
    if ([string]::IsNullOrEmpty($s)) { $isError = $true }
    elseif ($s -match '^\s*(Error|ERROR|✕|Error:|\[ERROR\])') { $isError = $true }
}

if ($isError) {
    Push-Island -State error -Message "$tool failed"
} else {
    Push-Island -State done -Message "$tool ok"
}
exit 0
