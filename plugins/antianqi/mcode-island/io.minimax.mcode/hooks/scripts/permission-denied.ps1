# Hook: PermissionDenied
# Event:  io.minimax.mcode / PermissionDenied
# State:  error
# Note:   Fires after a permission has been denied (rare in 0.2.4
#         per the spec; treat as advisory). We push error so the
#         user sees the pill turn red and knows to investigate.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$tool = if ($evt.tool_name) { [string]$evt.tool_name } else { 'permission' }
Push-Island -State error -Message "$tool denied"
exit 0
