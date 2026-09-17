# Hook: SubagentStop
# Event:  io.minimax.mcode / SubagentStop
# State:  done
# Note:   Fires when a delegated subagent finishes. We push done;
#         the pill goes green. If the main agent subsequently calls
#         another tool, PreToolUse will turn it back to working.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$name = if ($evt.subagent_type) { [string]$evt.subagent_type } else { 'subagent' }
Push-Island -State done -Message "$name returned"
exit 0
