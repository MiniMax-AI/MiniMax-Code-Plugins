# Hook: Stop
# Event:  io.minimax.mcode / Stop
# State:  done
# Note:   Fires when the agent finishes a turn (one model response,
#         any number of tool calls). This is the natural "this turn
#         is done" signal — the pill goes green until the next
#         UserPromptSubmit turns it yellow again.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$reason = if ($evt.stop_reason) { [string]$evt.stop_reason } else { 'turn complete' }
Push-Island -State done -Message $reason
exit 0
