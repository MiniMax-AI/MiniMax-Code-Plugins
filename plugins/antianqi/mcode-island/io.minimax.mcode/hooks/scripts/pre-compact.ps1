# Hook: PreCompact
# Event:  io.minimax.mcode / PreCompact
# State:  thinking
# Note:   Fires before the runtime compresses context. We push
#         thinking so the pill signals "agent is still doing
#         something" — without this, the pill might sit in `done`
#         while the model is mid-compaction and the user wonders
#         whether the agent is alive.
. "$PSScriptRoot\_lib.ps1"
$evt = Read-HookStdin
$trigger = if ($evt.trigger) { [string]$evt.trigger } else { 'context' }
Push-Island -State thinking -Message "compacting ($trigger)"
exit 0
