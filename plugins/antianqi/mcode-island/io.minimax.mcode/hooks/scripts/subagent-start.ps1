# Hook: SubagentStart
# Event:  io.minimax.mcode / SubagentStart
# State:  working
# Note:   Fires when the agent delegates a subtask to a subagent.
#         Bridged only on the CODEX native client surface; no
#         deliveries on CLAUDE. We push working so the pill
#         reflects the visible "the agent is still busy" state
#         even though the work is happening in a child context.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$name = if ($evt.subagent_type) { [string]$evt.subagent_type } else { 'subagent' }
$desc = if ($evt.description) { [string]$evt.description } else { '' }
if ($desc.Length -gt 60) { $desc = $desc.Substring(0, 57) + '...' }
$msg = if ($desc) { "delegate: $name - $desc" } else { "delegate: $name" }
Push-Island -State working -Message $msg
exit 0
